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

// Mock external dependencies
vi.mock("../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: vi.fn().mockResolvedValue("test-user-prepare"),
}));

vi.mock("../../../../../src/lib/s3/s3-client", () => ({
  generatePresignedPutUrl: vi
    .fn()
    .mockResolvedValue("https://s3.example.com/presigned-url"),
  downloadManifest: vi.fn().mockResolvedValue({ files: [] }),
}));

// Set required environment variables
process.env.R2_USER_STORAGES_BUCKET_NAME = "test-storages-bucket";

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
    // Override mock to return null
    const { getUserId } = await import(
      "../../../../../src/lib/auth/get-user-id"
    );
    vi.mocked(getUserId).mockResolvedValueOnce(null);

    const { POST } = await import("../route");

    const request = new Request("http://localhost:3000/api/storages/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName: "test",
        storageType: "volume",
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

    const request = new Request("http://localhost:3000/api/storages/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageType: "volume",
        files: [],
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 when storageType is invalid", async () => {
    const { POST } = await import("../route");

    const request = new Request("http://localhost:3000/api/storages/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName: "test",
        storageType: "invalid",
        files: [],
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("BAD_REQUEST");
  });

  it("should create new storage when it does not exist", async () => {
    const { POST } = await import("../route");
    const storageName = `${TEST_PREFIX}new-storage`;

    const request = new Request("http://localhost:3000/api/storages/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName,
        storageType: "volume",
        files: [{ path: "test.txt", hash: "abc123", size: 100 }],
      }),
    });

    const response = await POST(
      request as unknown as import("next/server").NextRequest,
    );
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
    const { POST } = await import("../route");
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
    const files = [{ path: "test.txt", hash: "abc123def456", size: 100 }];
    const request1 = new Request("http://localhost:3000/api/storages/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storageName, storageType: "volume", files }),
    });

    const response1 = await POST(
      request1 as unknown as import("next/server").NextRequest,
    );
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
    const request2 = new Request("http://localhost:3000/api/storages/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storageName, storageType: "volume", files }),
    });

    const response2 = await POST(
      request2 as unknown as import("next/server").NextRequest,
    );
    expect(response2.status).toBe(200);

    const json2 = await response2.json();
    expect(json2.versionId).toBe(versionId);
    expect(json2.existing).toBe(true);
    expect(json2.uploads).toBeUndefined();
  });

  it("should compute deterministic version ID from files", async () => {
    const { POST } = await import("../route");
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
      { path: "a.txt", hash: "hash1", size: 10 },
      { path: "b.txt", hash: "hash2", size: 20 },
    ];

    // Make two requests with same files
    const request1 = new Request("http://localhost:3000/api/storages/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storageName, storageType: "artifact", files }),
    });

    const request2 = new Request("http://localhost:3000/api/storages/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storageName, storageType: "artifact", files }),
    });

    const response1 = await POST(
      request1 as unknown as import("next/server").NextRequest,
    );
    const response2 = await POST(
      request2 as unknown as import("next/server").NextRequest,
    );

    const json1 = await response1.json();
    const json2 = await response2.json();

    // Version IDs should be identical
    expect(json1.versionId).toBe(json2.versionId);
    expect(json1.versionId).toHaveLength(64);
  });
});
