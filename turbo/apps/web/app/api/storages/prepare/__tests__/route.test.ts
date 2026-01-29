import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../route";
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

describe("POST /api/storages/prepare", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName: "test",
          storageType: "volume",
          files: [],
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("should return 400 when storageName is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageType: "volume",
          files: [],
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 when storageType is invalid", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName: "test",
          storageType: "invalid",
          files: [],
        }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("BAD_REQUEST");
  });

  it("should create new storage when it does not exist", async () => {
    const storageName = `new-storage-${Date.now()}`;

    const request = createTestRequest(
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

    const response = await POST(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.versionId).toBeDefined();
    expect(json.existing).toBe(false);
    expect(json.uploads).toBeDefined();
    expect(json.uploads.archive).toBeDefined();
    expect(json.uploads.manifest).toBeDefined();
  });

  it("should return existing=true when version already exists", async () => {
    const storageName = `existing-version-${Date.now()}`;
    const files = [{ path: "test.txt", hash: "b".repeat(64), size: 100 }];

    // Create storage and commit version via helper
    await createTestArtifact(storageName, { files });

    // Prepare again with same files - should return existing: true
    const request = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "artifact", files }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.existing).toBe(true);
    expect(json.uploads).toBeUndefined();
  });

  it("should compute deterministic version ID from files", async () => {
    const storageName = `deterministic-${Date.now()}`;
    const files = [
      { path: "a.txt", hash: "c".repeat(64), size: 10 },
      { path: "b.txt", hash: "d".repeat(64), size: 20 },
    ];

    // Make two requests with same files
    const request1 = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "artifact", files }),
      },
    );

    const response1 = await POST(request1);
    const json1 = await response1.json();

    const request2 = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "artifact", files }),
      },
    );

    const response2 = await POST(request2);
    const json2 = await response2.json();

    // Version IDs should be identical
    expect(json1.versionId).toBe(json2.versionId);
    expect(json1.versionId).toHaveLength(64);
  });

  it("should return upload URLs when version exists but S3 files are missing", async () => {
    const storageName = `s3missing-${Date.now()}`;
    const files = [{ path: "test.txt", hash: "e".repeat(64), size: 100 }];

    // Create storage and commit version via helper
    const { versionId } = await createTestArtifact(storageName, { files });

    // Mock S3 files as missing
    context.mocks.s3.verifyS3FilesExist.mockResolvedValueOnce(false);

    // Prepare again with same files - should get upload URLs since S3 missing
    const request = createTestRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "artifact", files }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.versionId).toBe(versionId);
    // Should NOT return existing: true since S3 files are missing
    expect(json.existing).toBe(false);
    // Should return upload URLs for re-upload
    expect(json.uploads).toBeDefined();
    expect(json.uploads.archive.key).toBeDefined();
    expect(json.uploads.archive.presignedUrl).toBe(
      "https://mock-presigned-put-url",
    );
    expect(json.uploads.manifest.key).toBeDefined();
    expect(json.uploads.manifest.presignedUrl).toBe(
      "https://mock-presigned-put-url",
    );
  });
});
