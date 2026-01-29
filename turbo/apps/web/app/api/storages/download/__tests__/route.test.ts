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
});
