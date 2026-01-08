import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import {
  storages,
  storageVersions,
} from "../../../../../src/db/schema/storage";

// Mock external dependencies - vi.mock() is hoisted, so mocks are ready before imports
vi.mock("../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: vi.fn().mockResolvedValue("test-user-prepare"),
}));

vi.mock("../../../../../src/lib/s3/s3-client", () => ({
  generatePresignedPutUrl: vi
    .fn()
    .mockResolvedValue("https://s3.example.com/presigned-url"),
  downloadManifest: vi.fn().mockResolvedValue({ files: [] }),
  verifyS3FilesExist: vi.fn().mockResolvedValue(true),
}));

// Set required environment variables
process.env.R2_USER_STORAGES_BUCKET_NAME = "test-storages-bucket";

// Static imports - mocks are already in place due to hoisting
import { POST } from "../route";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { verifyS3FilesExist } from "../../../../../src/lib/s3/s3-client";

// Test constants
const TEST_USER_ID = "test-user-prepare";
const TEST_PREFIX = "test-prepare-";

describe("POST /api/storages/prepare", () => {
  beforeAll(async () => {
    initServices();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clean up test data
    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: null })
      .where(eq(storages.userId, TEST_USER_ID));

    const testStorages = await globalThis.services.db
      .select({ id: storages.id })
      .from(storages)
      .where(eq(storages.userId, TEST_USER_ID));

    for (const storage of testStorages) {
      await globalThis.services.db
        .delete(storageVersions)
        .where(eq(storageVersions.storageId, storage.id));
    }

    await globalThis.services.db
      .delete(storages)
      .where(eq(storages.userId, TEST_USER_ID));
  });

  afterAll(async () => {
    // Final cleanup
    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: null })
      .where(eq(storages.userId, TEST_USER_ID));

    const testStorages = await globalThis.services.db
      .select({ id: storages.id })
      .from(storages)
      .where(eq(storages.userId, TEST_USER_ID));

    for (const storage of testStorages) {
      await globalThis.services.db
        .delete(storageVersions)
        .where(eq(storageVersions.storageId, storage.id));
    }

    await globalThis.services.db
      .delete(storages)
      .where(eq(storages.userId, TEST_USER_ID));
  });

  it("should return 401 when not authenticated", async () => {
    // Override mock to return null for this test
    vi.mocked(getUserId).mockResolvedValueOnce(null);

    const request = new NextRequest(
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
    const request = new NextRequest(
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
    const request = new NextRequest(
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
    const storageName = `${TEST_PREFIX}new-storage`;

    const request = new NextRequest(
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

    // Verify storage was created
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(eq(storages.name, storageName));
    expect(storage).toBeDefined();
    expect(storage!.userId).toBe(TEST_USER_ID);
  });

  it("should return existing=true when version already exists", async () => {
    const storageName = `${TEST_PREFIX}existing-version`;

    // Create storage first
    const [storage] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: TEST_USER_ID,
        name: storageName,
        type: "volume",
        s3Prefix: `${TEST_USER_ID}/volume/${storageName}`,
        size: 100,
        fileCount: 1,
      })
      .returning();

    // Prepare with same files to get the version ID
    const files = [{ path: "test.txt", hash: "b".repeat(64), size: 100 }];
    const request1 = new NextRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "volume", files }),
      },
    );

    const response1 = await POST(request1);
    const json1 = await response1.json();
    const versionId = json1.versionId;

    // Create version record
    await globalThis.services.db.insert(storageVersions).values({
      id: versionId,
      storageId: storage!.id,
      s3Key: `${TEST_USER_ID}/volume/${storageName}/${versionId}`,
      size: 100,
      fileCount: 1,
      createdBy: TEST_USER_ID,
    });

    // Prepare again with same files
    const request2 = new NextRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "volume", files }),
      },
    );

    const response2 = await POST(request2);
    expect(response2.status).toBe(200);

    const json2 = await response2.json();
    expect(json2.versionId).toBe(versionId);
    expect(json2.existing).toBe(true);
    expect(json2.uploads).toBeUndefined();
  });

  it("should compute deterministic version ID from files", async () => {
    const storageName = `${TEST_PREFIX}deterministic`;

    // Create storage
    await globalThis.services.db.insert(storages).values({
      userId: TEST_USER_ID,
      name: storageName,
      type: "artifact",
      s3Prefix: `${TEST_USER_ID}/artifact/${storageName}`,
      size: 0,
      fileCount: 0,
    });

    const files = [
      { path: "a.txt", hash: "c".repeat(64), size: 10 },
      { path: "b.txt", hash: "d".repeat(64), size: 20 },
    ];

    // Make two requests with same files
    const request1 = new NextRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "artifact", files }),
      },
    );

    const request2 = new NextRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "artifact", files }),
      },
    );

    const response1 = await POST(request1);
    const response2 = await POST(request2);

    const json1 = await response1.json();
    const json2 = await response2.json();

    // Version IDs should be identical
    expect(json1.versionId).toBe(json2.versionId);
    expect(json1.versionId).toHaveLength(64);
  });

  it("should return upload URLs when version exists but S3 files are missing", async () => {
    const storageName = `${TEST_PREFIX}s3missing`;

    // Create storage
    const [storage] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: TEST_USER_ID,
        name: storageName,
        type: "volume",
        s3Prefix: `${TEST_USER_ID}/volume/${storageName}`,
        size: 100,
        fileCount: 1,
      })
      .returning();

    // Prepare with files to get the version ID
    const files = [{ path: "test.txt", hash: "e".repeat(64), size: 100 }];
    const request1 = new NextRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "volume", files }),
      },
    );

    const response1 = await POST(request1);
    const json1 = await response1.json();
    const versionId = json1.versionId;

    // Create version record (simulating DB has record but S3 files deleted)
    await globalThis.services.db.insert(storageVersions).values({
      id: versionId,
      storageId: storage!.id,
      s3Key: `${TEST_USER_ID}/volume/${storageName}/${versionId}`,
      size: 100,
      fileCount: 1,
      createdBy: TEST_USER_ID,
    });

    // Mock S3 files as missing
    vi.mocked(verifyS3FilesExist).mockResolvedValueOnce(false);

    // Prepare again with same files - should get upload URLs since S3 missing
    const request2 = new NextRequest(
      "http://localhost:3000/api/storages/prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageName, storageType: "volume", files }),
      },
    );

    const response2 = await POST(request2);
    expect(response2.status).toBe(200);

    const json2 = await response2.json();
    expect(json2.versionId).toBe(versionId);
    // Should NOT return existing: true since S3 files are missing
    expect(json2.existing).toBe(false);
    // Should return upload URLs for re-upload
    expect(json2.uploads).toBeDefined();
    expect(json2.uploads.archive.presignedUrl).toBeDefined();
    expect(json2.uploads.manifest.presignedUrl).toBeDefined();
  });
});
