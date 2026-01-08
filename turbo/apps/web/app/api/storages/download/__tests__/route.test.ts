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

// Mock external dependencies
vi.mock("../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: vi.fn().mockResolvedValue("test-user-download"),
}));

vi.mock("../../../../../src/lib/s3/s3-client", () => ({
  generatePresignedUrl: vi
    .fn()
    .mockResolvedValue("https://s3.example.com/presigned-download-url"),
}));

// Set required environment variables
process.env.R2_USER_STORAGES_BUCKET_NAME = "test-storages-bucket";

// Static imports - mocks are already in place due to hoisting
import { GET } from "../route";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";

// Test constants
const TEST_USER_ID = "test-user-download";
const TEST_PREFIX = "test-download-";

describe("GET /api/storages/download", () => {
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
    vi.mocked(getUserId).mockResolvedValueOnce(null);

    const request = new NextRequest(
      "http://localhost:3000/api/storages/download?name=test&type=volume",
    );

    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("should return 400 when name parameter is missing", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/storages/download?type=volume",
    );

    const response = await GET(request);
    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error.message).toContain("name");
  });

  it("should return 400 when type parameter is missing", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/storages/download?name=test",
    );

    const response = await GET(request);
    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error.message).toContain("type");
  });

  it("should return 400 when type is invalid", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/storages/download?name=test&type=invalid",
    );

    const response = await GET(request);
    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error.message).toContain("type");
  });

  it("should return 404 when storage does not exist", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/storages/download?name=nonexistent&type=volume",
    );

    const response = await GET(request);
    expect(response.status).toBe(404);
  });

  it("should return 404 when storage has no versions", async () => {
    const storageName = `${TEST_PREFIX}no-versions`;

    // Create storage without versions
    await globalThis.services.db.insert(storages).values({
      userId: TEST_USER_ID,
      name: storageName,
      type: "volume",
      s3Prefix: `${TEST_USER_ID}/volume/${storageName}`,
      size: 0,
      fileCount: 0,
      headVersionId: null,
    });

    const request = new NextRequest(
      `http://localhost:3000/api/storages/download?name=${storageName}&type=volume`,
    );

    const response = await GET(request);
    expect(response.status).toBe(404);

    const json = await response.json();
    expect(json.error.message).toContain("no versions");
  });

  it("should return empty=true for empty storage", async () => {
    const storageName = `${TEST_PREFIX}empty`;
    const versionId = "a".repeat(64);

    // Create storage with empty version
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

    await globalThis.services.db.insert(storageVersions).values({
      id: versionId,
      storageId: storage!.id,
      s3Key: `${TEST_USER_ID}/volume/${storageName}/${versionId}`,
      size: 0,
      fileCount: 0,
      createdBy: "user",
    });

    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: versionId })
      .where(eq(storages.id, storage!.id));

    const request = new NextRequest(
      `http://localhost:3000/api/storages/download?name=${storageName}&type=volume`,
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
    const storageName = `${TEST_PREFIX}with-files`;
    const versionId = "b".repeat(64);

    // Create storage with version that has files
    const [storage] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: TEST_USER_ID,
        name: storageName,
        type: "volume",
        s3Prefix: `${TEST_USER_ID}/volume/${storageName}`,
        size: 1000,
        fileCount: 5,
      })
      .returning();

    await globalThis.services.db.insert(storageVersions).values({
      id: versionId,
      storageId: storage!.id,
      s3Key: `${TEST_USER_ID}/volume/${storageName}/${versionId}`,
      size: 1000,
      fileCount: 5,
      createdBy: "user",
    });

    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: versionId })
      .where(eq(storages.id, storage!.id));

    const request = new NextRequest(
      `http://localhost:3000/api/storages/download?name=${storageName}&type=volume`,
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.url).toBe("https://s3.example.com/presigned-download-url");
    expect(json.versionId).toBe(versionId);
    expect(json.fileCount).toBe(5);
    expect(json.size).toBe(1000);
    expect(json.empty).toBeUndefined();
  });

  it("should return presigned URL for specific version", async () => {
    const storageName = `${TEST_PREFIX}specific-version`;
    const version1Id = "c".repeat(64);
    const version2Id = "d".repeat(64);

    // Create storage with multiple versions
    const [storage] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: TEST_USER_ID,
        name: storageName,
        type: "artifact",
        s3Prefix: `${TEST_USER_ID}/artifact/${storageName}`,
        size: 2000,
        fileCount: 10,
      })
      .returning();

    await globalThis.services.db.insert(storageVersions).values([
      {
        id: version1Id,
        storageId: storage!.id,
        s3Key: `${TEST_USER_ID}/artifact/${storageName}/${version1Id}`,
        size: 500,
        fileCount: 2,
        createdBy: "user",
      },
      {
        id: version2Id,
        storageId: storage!.id,
        s3Key: `${TEST_USER_ID}/artifact/${storageName}/${version2Id}`,
        size: 2000,
        fileCount: 10,
        createdBy: "user",
      },
    ]);

    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: version2Id })
      .where(eq(storages.id, storage!.id));

    // Request specific older version
    const request = new NextRequest(
      `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${version1Id}`,
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.versionId).toBe(version1Id);
    expect(json.fileCount).toBe(2);
    expect(json.size).toBe(500);
  });
});
