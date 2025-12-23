/**
 * @vitest-environment node
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import {
  storages,
  storageVersions,
} from "../../../../../src/db/schema/storage";
import { blobs } from "../../../../../src/db/schema/blob";
import { computeContentHashFromHashes } from "../../../../../src/lib/storage/content-hash";

// Mock external dependencies
vi.mock("../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: vi.fn().mockResolvedValue("test-user-commit"),
}));

vi.mock("../../../../../src/lib/s3/s3-client", () => ({
  s3ObjectExists: vi.fn().mockResolvedValue(true),
  verifyS3FilesExist: vi.fn().mockResolvedValue(true),
}));

// Set required environment variables
process.env.R2_USER_STORAGES_BUCKET_NAME = "test-storages-bucket";

// Test constants
const TEST_USER_ID = "test-user-commit";
const TEST_PREFIX = "test-commit-";

describe("POST /api/storages/commit", () => {
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
    const { getUserId } = await import(
      "../../../../../src/lib/auth/get-user-id"
    );
    vi.mocked(getUserId).mockResolvedValueOnce(null);

    const { POST } = await import("../route");

    const request = new Request("http://localhost:3000/api/storages/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName: "test",
        storageType: "volume",
        versionId: "abc123",
        files: [],
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(401);
  });

  it("should return 400 when storageName is missing", async () => {
    const { POST } = await import("../route");

    const request = new Request("http://localhost:3000/api/storages/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageType: "volume",
        versionId: "abc123",
        files: [],
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(400);
  });

  it("should return 404 when storage does not exist", async () => {
    const { POST } = await import("../route");

    const request = new Request("http://localhost:3000/api/storages/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName: "nonexistent-storage",
        storageType: "volume",
        versionId: "abc123",
        files: [],
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(404);
  });

  it("should return 400 when versionId does not match computed hash", async () => {
    const { POST } = await import("../route");
    const storageName = `${TEST_PREFIX}mismatch`;

    // Create storage
    await globalThis.services.db.insert(storages).values({
      userId: TEST_USER_ID,
      name: storageName,
      type: "volume",
      s3Prefix: `${TEST_USER_ID}/volume/${storageName}`,
      size: 0,
      fileCount: 0,
    });

    const request = new Request("http://localhost:3000/api/storages/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName,
        storageType: "volume",
        versionId: "wrong_version_id",
        files: [{ path: "test.txt", hash: "abc123", size: 100 }],
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.message).toContain("mismatch");
  });

  it("should return 400 when S3 objects do not exist", async () => {
    const { s3ObjectExists } = await import(
      "../../../../../src/lib/s3/s3-client"
    );
    vi.mocked(s3ObjectExists).mockResolvedValueOnce(false); // manifest doesn't exist

    const { POST } = await import("../route");
    const storageName = `${TEST_PREFIX}missing-s3`;

    // Create storage
    const [storage] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: TEST_USER_ID,
        name: storageName,
        type: "volume",
        s3Prefix: `${TEST_USER_ID}/volume/${storageName}`,
        size: 0,
        fileCount: 0,
      })
      .returning();

    const files = [{ path: "test.txt", hash: "abc123", size: 100 }];
    const versionId = computeContentHashFromHashes(storage!.id, files);

    const request = new Request("http://localhost:3000/api/storages/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName,
        storageType: "volume",
        versionId,
        files,
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.message).toContain("not uploaded");
  });

  it("should create version and update HEAD on successful commit", async () => {
    const { POST } = await import("../route");
    const storageName = `${TEST_PREFIX}success`;

    // Create storage
    const [storage] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: TEST_USER_ID,
        name: storageName,
        type: "artifact",
        s3Prefix: `${TEST_USER_ID}/artifact/${storageName}`,
        size: 0,
        fileCount: 0,
      })
      .returning();

    const files = [
      {
        path: "file1.txt",
        hash: "hash1_abcdef1234567890abcdef1234567890abcdef1234",
        size: 100,
      },
      {
        path: "file2.txt",
        hash: "hash2_abcdef1234567890abcdef1234567890abcdef1234",
        size: 200,
      },
    ];
    const versionId = computeContentHashFromHashes(storage!.id, files);

    const request = new Request("http://localhost:3000/api/storages/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName,
        storageType: "artifact",
        versionId,
        files,
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.versionId).toBe(versionId);
    expect(json.fileCount).toBe(2);
    expect(json.size).toBe(300);

    // Verify version was created
    const [version] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(eq(storageVersions.id, versionId));
    expect(version).toBeDefined();
    expect(version!.storageId).toBe(storage!.id);

    // Verify HEAD was updated
    const [updatedStorage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(eq(storages.id, storage!.id));
    expect(updatedStorage!.headVersionId).toBe(versionId);

    // Clean up blobs created
    await globalThis.services.db
      .delete(blobs)
      .where(eq(blobs.hash, files[0]!.hash));
    await globalThis.services.db
      .delete(blobs)
      .where(eq(blobs.hash, files[1]!.hash));
  });

  it("should commit empty artifact without requiring archive in S3", async () => {
    // This test verifies the fix for issue #617:
    // Empty artifacts (fileCount === 0) should not require archive.tar.gz in S3
    const { s3ObjectExists } = await import(
      "../../../../../src/lib/s3/s3-client"
    );
    // Mock: manifest exists (only one call expected for empty artifact)
    vi.mocked(s3ObjectExists).mockResolvedValueOnce(true); // manifest exists

    const { POST } = await import("../route");
    const storageName = `${TEST_PREFIX}empty`;

    // Create storage
    const [storage] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: TEST_USER_ID,
        name: storageName,
        type: "artifact",
        s3Prefix: `${TEST_USER_ID}/artifact/${storageName}`,
        size: 0,
        fileCount: 0,
      })
      .returning();

    // Empty files array
    const files: { path: string; hash: string; size: number }[] = [];
    const versionId = computeContentHashFromHashes(storage!.id, files);

    const request = new Request("http://localhost:3000/api/storages/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName,
        storageType: "artifact",
        versionId,
        files,
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.versionId).toBe(versionId);
    expect(json.fileCount).toBe(0);
    expect(json.size).toBe(0);

    // Verify HEAD was updated to empty version
    const [updatedStorage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(eq(storages.id, storage!.id));
    expect(updatedStorage!.headVersionId).toBe(versionId);

    // Verify s3ObjectExists was only called once (for manifest, not archive)
    expect(s3ObjectExists).toHaveBeenCalledTimes(1);
  });

  it("should return deduplicated=true when version already exists", async () => {
    const { POST } = await import("../route");
    const storageName = `${TEST_PREFIX}idempotent`;

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

    const files = [
      {
        path: "test.txt",
        hash: "idempotent_hash_abcdef1234567890abcdef",
        size: 100,
      },
    ];
    const versionId = computeContentHashFromHashes(storage!.id, files);

    // Create version first
    await globalThis.services.db.insert(storageVersions).values({
      id: versionId,
      storageId: storage!.id,
      s3Key: `${TEST_USER_ID}/volume/${storageName}/${versionId}`,
      size: 100,
      fileCount: 1,
      createdBy: TEST_USER_ID,
    });

    // Update HEAD
    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: versionId })
      .where(eq(storages.id, storage!.id));

    // Commit again
    const request = new Request("http://localhost:3000/api/storages/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName,
        storageType: "volume",
        versionId,
        files,
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.deduplicated).toBe(true);
  });

  it("should return 409 when version exists but S3 files are missing", async () => {
    // This test verifies the fix for issue #658:
    // Commit should fail with 409 if S3 files are missing for existing version
    const s3Mock = await import("../../../../../src/lib/s3/s3-client");
    const verifyS3FilesMock = vi.mocked(s3Mock.verifyS3FilesExist);

    // Mock S3 files as missing for existing version
    verifyS3FilesMock.mockResolvedValueOnce(false);

    const { POST } = await import("../route");
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

    const files = [
      {
        path: "test.txt",
        hash: "s3missing_hash_abcdef1234567890abcdef",
        size: 100,
      },
    ];
    const versionId = computeContentHashFromHashes(storage!.id, files);

    // Create version record (simulating DB has record but S3 files deleted)
    await globalThis.services.db.insert(storageVersions).values({
      id: versionId,
      storageId: storage!.id,
      s3Key: `${TEST_USER_ID}/volume/${storageName}/${versionId}`,
      size: 100,
      fileCount: 1,
      createdBy: TEST_USER_ID,
    });

    // Commit should fail because S3 files are missing
    const request = new Request("http://localhost:3000/api/storages/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName,
        storageType: "volume",
        versionId,
        files,
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(409);

    const json = await response.json();
    expect(json.error.code).toBe("S3_FILES_MISSING");
    expect(json.error.message).toContain("S3 files missing");
  });
});
