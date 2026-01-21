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
import { blobs } from "../../../../../src/db/schema/blob";
import { computeContentHashFromHashes } from "../../../../../src/lib/storage/content-hash";
import * as s3Client from "../../../../../src/lib/s3/s3-client";

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock AWS SDK (external) for S3 operations
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

// Set required environment variables
process.env.R2_USER_STORAGES_BUCKET_NAME = "test-storages-bucket";

// Static imports - mocks are already in place due to hoisting
import { POST } from "../route";
import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

// Test constants
const TEST_USER_ID = "test-user-commit";
const TEST_PREFIX = "test-commit-";

describe("POST /api/storages/commit", () => {
  beforeAll(async () => {
    initServices();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup S3 mocks
    vi.spyOn(s3Client, "s3ObjectExists").mockResolvedValue(true);
    vi.spyOn(s3Client, "verifyS3FilesExist").mockResolvedValue(true);

    // Mock headers() - return empty headers so auth falls through to Clerk
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Mock Clerk auth to return test user by default
    mockAuth.mockResolvedValue({
      userId: TEST_USER_ID,
    } as unknown as Awaited<ReturnType<typeof auth>>);

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
    mockAuth.mockResolvedValueOnce({ userId: null } as unknown as Awaited<
      ReturnType<typeof auth>
    >);

    const request = new NextRequest(
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
    const request = new NextRequest(
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
    const request = new NextRequest(
      "http://localhost:3000/api/storages/commit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageName: "nonexistent-storage",
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

    const request = new NextRequest(
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
    vi.spyOn(s3Client, "s3ObjectExists").mockResolvedValueOnce(false); // manifest doesn't exist

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

    const files = [{ path: "test.txt", hash: "b".repeat(64), size: 100 }];
    const versionId = computeContentHashFromHashes(storage!.id, files);

    const request = new NextRequest(
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
        hash: "e".repeat(64),
        size: 100,
      },
      {
        path: "file2.txt",
        hash: "f".repeat(64),
        size: 200,
      },
    ];
    const versionId = computeContentHashFromHashes(storage!.id, files);

    const request = new NextRequest(
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
      .where(eq(blobs.hash, "e".repeat(64)));
    await globalThis.services.db
      .delete(blobs)
      .where(eq(blobs.hash, "f".repeat(64)));
  });

  it("should commit empty artifact without requiring archive in S3", async () => {
    // This test verifies the fix for issue #617:
    // Empty artifacts (fileCount === 0) should not require archive.tar.gz in S3
    // Mock: manifest exists (only one call expected for empty artifact)
    vi.spyOn(s3Client, "s3ObjectExists").mockResolvedValueOnce(true); // manifest exists

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

    const request = new NextRequest(
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

    // Verify HEAD was updated to empty version
    const [updatedStorage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(eq(storages.id, storage!.id));
    expect(updatedStorage!.headVersionId).toBe(versionId);

    // Verify s3ObjectExists was only called once (for manifest, not archive)
    expect(vi.mocked(s3Client.s3ObjectExists)).toHaveBeenCalledTimes(1);
  });

  it("should return deduplicated=true when version already exists", async () => {
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
        hash: "d".repeat(64),
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
    const request = new NextRequest(
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
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.deduplicated).toBe(true);
  });

  it("should return 409 when version exists but S3 files are missing", async () => {
    // This test verifies the fix for issue #658:
    // Commit should fail with 409 if S3 files are missing for existing version
    // Mock S3 files as missing for existing version
    vi.spyOn(s3Client, "verifyS3FilesExist").mockResolvedValueOnce(false);

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
        hash: "c".repeat(64),
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
    const request = new NextRequest(
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
    expect(response.status).toBe(409);

    const json = await response.json();
    expect(json.error.code).toBe("S3_FILES_MISSING");
    expect(json.error.message).toContain("S3 files missing");
  });

  it("should handle concurrent commit race condition gracefully", async () => {
    // This test verifies the fix for issue #766:
    // When onConflictDoNothing skips the insert (due to concurrent transaction),
    // the code verifies the version exists before updating HEAD pointer.
    // If the version doesn't exist (concurrent transaction hasn't committed),
    // the commit should fail with a clear error message instead of FK violation.
    const storageName = `${TEST_PREFIX}race-condition`;

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
        path: "race.txt",
        hash: "f".repeat(64),
        size: 50,
      },
    ];
    const versionId = computeContentHashFromHashes(storage!.id, files);

    // Mock the transaction to simulate a race condition:
    // - onConflictDoNothing skips the insert (as if another transaction holds the lock)
    // - The SELECT inside transaction returns empty (version doesn't exist yet)
    const originalTransaction = globalThis.services.db.transaction;
    globalThis.services.db.transaction = vi
      .fn()
      .mockImplementationOnce(
        async (callback: (tx: unknown) => Promise<void>) => {
          // Create a mock transaction context that simulates the race condition
          const mockTx = {
            insert: () => ({
              values: () => ({
                onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
              }),
            }),
            select: () => ({
              from: () => ({
                where: () => ({
                  limit: vi.fn().mockResolvedValue([]), // Version not found - simulates race
                }),
              }),
            }),
            update: () => ({
              set: () => ({
                where: vi.fn().mockResolvedValue(undefined),
              }),
            }),
          };

          return callback(mockTx);
        },
      ) as typeof originalTransaction;

    const request = new NextRequest(
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

    // Should return 500 with clear error message about concurrent transaction
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error.message).toContain("not found after insert");
    expect(json.error.message).toContain("concurrent transaction");

    // Restore original transaction
    globalThis.services.db.transaction = originalTransaction;
  });
});
