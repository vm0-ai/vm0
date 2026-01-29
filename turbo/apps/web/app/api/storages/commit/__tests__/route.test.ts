import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../route";
import { POST as preparePOST } from "../../prepare/route";
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

describe("POST /api/storages/commit", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/storages/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName: "test",
          storageType: "volume",
          versionId: "abc123",
          files: [],
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("should return 400 when storageName is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/storages/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageType: "volume",
          versionId: "abc123",
          files: [],
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should return 404 when storage does not exist", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/storages/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName: `nonexistent-storage-${Date.now()}`,
          storageType: "volume",
          versionId: "abc123",
          files: [],
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(404);
  });

  it("should return 400 when versionId does not match computed hash", async () => {
    const storageName = `mismatch-${Date.now()}`;

    // Create storage via prepare route (creates storage but no version yet)
    const prepareRequest = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName,
          storageType: "volume",
          files: [{ path: "test.txt", hash: "a".repeat(64), size: 100 }],
        }),
      },
    );
    await preparePOST(prepareRequest);

    // Commit with wrong version ID
    const request = createTestRequest(
      "http://localhost:3000/api/storages/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName,
          storageType: "volume",
          versionId: "wrong_version_id",
          files: [{ path: "test.txt", hash: "a".repeat(64), size: 100 }],
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.message).toContain("mismatch");
  });

  it("should return 400 when S3 objects do not exist", async () => {
    // Mock manifest as not existing
    context.mocks.s3.s3ObjectExists.mockResolvedValueOnce(false);

    const storageName = `missing-s3-${Date.now()}`;
    const files = [{ path: "test.txt", hash: "b".repeat(64), size: 100 }];

    // Create storage via prepare route
    const prepareRequest = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "volume", files }),
      },
    );
    const prepareResponse = await preparePOST(prepareRequest);
    const prepareData = await prepareResponse.json();
    const { versionId } = prepareData;

    // Commit - should fail because manifest doesn't exist
    const request = createTestRequest(
      "http://localhost:3000/api/storages/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName,
          storageType: "volume",
          versionId,
          files,
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.message).toContain("not uploaded");
  });

  it("should create version and update HEAD on successful commit", async () => {
    const storageName = `success-${Date.now()}`;
    const files = [
      { path: "file1.txt", hash: "e".repeat(64), size: 100 },
      { path: "file2.txt", hash: "f".repeat(64), size: 200 },
    ];

    // Create storage via prepare route
    const prepareRequest = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "artifact", files }),
      },
    );
    const prepareResponse = await preparePOST(prepareRequest);
    const prepareData = await prepareResponse.json();
    const { versionId } = prepareData;

    // Commit
    const request = createTestRequest(
      "http://localhost:3000/api/storages/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName,
          storageType: "artifact",
          versionId,
          files,
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.versionId).toBe(versionId);
    expect(json.fileCount).toBe(2);
    expect(json.size).toBe(300);
  });

  it("should commit empty artifact without requiring archive in S3", async () => {
    // This test verifies the fix for issue #617:
    // Empty artifacts (fileCount === 0) should not require archive.tar.gz in S3
    const storageName = `empty-${Date.now()}`;
    const files: { path: string; hash: string; size: number }[] = [];

    // Create storage via prepare route
    const prepareRequest = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "artifact", files }),
      },
    );
    const prepareResponse = await preparePOST(prepareRequest);
    const prepareData = await prepareResponse.json();
    const { versionId } = prepareData;

    // Mock only manifest exists call (should only be called once for empty artifact)
    context.mocks.s3.s3ObjectExists.mockResolvedValueOnce(true);

    // Commit
    const request = createTestRequest(
      "http://localhost:3000/api/storages/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName,
          storageType: "artifact",
          versionId,
          files,
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.versionId).toBe(versionId);
    expect(json.fileCount).toBe(0);
    expect(json.size).toBe(0);

    // Verify s3ObjectExists was only called once (for manifest, not archive)
    expect(context.mocks.s3.s3ObjectExists).toHaveBeenCalledTimes(1);
  });

  it("should return deduplicated=true when version already exists", async () => {
    const storageName = `idempotent-${Date.now()}`;
    const files = [{ path: "test.txt", hash: "d".repeat(64), size: 100 }];

    // Create storage and commit version via helper
    const { versionId } = await createTestArtifact(storageName, { files });

    // Commit again with same version
    const request = createTestRequest(
      "http://localhost:3000/api/storages/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName,
          storageType: "artifact",
          versionId,
          files,
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.deduplicated).toBe(true);
  });

  it("should return 409 when version exists but S3 files are missing", async () => {
    // This test verifies the fix for issue #658:
    // Commit should fail with 409 if S3 files are missing for existing version
    const storageName = `s3missing-${Date.now()}`;
    const files = [{ path: "test.txt", hash: "c".repeat(64), size: 100 }];

    // Create storage and commit version via helper
    const { versionId } = await createTestArtifact(storageName, { files });

    // Mock S3 files as missing for existing version verification
    context.mocks.s3.verifyS3FilesExist.mockResolvedValueOnce(false);

    // Commit again - should fail because S3 files are missing
    const request = createTestRequest(
      "http://localhost:3000/api/storages/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName,
          storageType: "artifact",
          versionId,
          files,
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(409);

    const json = await response.json();
    expect(json.error.code).toBe("S3_FILES_MISSING");
    expect(json.error.message).toContain("S3 files missing");
  });
});
