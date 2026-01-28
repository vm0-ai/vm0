import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  storages,
  storageVersions,
} from "../../../../../../src/db/schema/storage";
import { scopes } from "../../../../../../src/db/schema/scope";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as s3Client from "../../../../../../src/lib/s3/s3-client";

/**
 * Helper to create a NextRequest for testing.
 */
function createTestRequest(url: string): NextRequest {
  return new NextRequest(url, {
    method: "GET",
  });
}

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock AWS SDK (external) for S3 operations
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

import { GET } from "../route";
import {
  mockClerk,
  clearClerkMock,
} from "../../../../../../src/__tests__/clerk-mock";

describe("GET /api/platform/artifacts/download", () => {
  const testUserId = "test-user-artifact-download";
  const testScopeId = randomUUID();
  const testScopeSlug = `test-download-${testScopeId.slice(0, 8)}`;
  const testArtifactName = "test-download-artifact";
  const testVersionId =
    "abc123def456789012345678901234567890123456789012345678901234";

  let testArtifactId: string;
  let testVersionDbId: string;

  beforeAll(async () => {
    initServices();

    // Clean up any existing test data
    await globalThis.services.db
      .delete(storages)
      .where(
        and(eq(storages.userId, testUserId), eq(storages.type, "artifact")),
      );

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope for the user
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: testScopeSlug,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test artifact
    const [artifact] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: testUserId,
        name: testArtifactName,
        type: "artifact",
        s3Prefix: `${testUserId}/artifact/${testArtifactName}`,
      })
      .returning();

    testArtifactId = artifact!.id;

    // Create a version for the artifact
    const [version] = await globalThis.services.db
      .insert(storageVersions)
      .values({
        id: testVersionId,
        storageId: testArtifactId,
        s3Key: `${testUserId}/artifact/${testArtifactName}/${testVersionId}`,
        fileCount: 5,
        size: 1024,
        createdBy: testUserId,
      })
      .returning();

    testVersionDbId = version!.id;

    // Update artifact with head version
    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: testVersionDbId })
      .where(eq(storages.id, testArtifactId));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock Clerk auth to return test user by default
    mockClerk({ userId: testUserId });
    // Mock presigned URL generation
    vi.spyOn(s3Client, "generatePresignedUrl").mockResolvedValue(
      "https://example.com/presigned-url",
    );
  });

  afterAll(async () => {
    clearClerkMock();

    // Cleanup test data - first clear headVersionId reference, then delete versions, then storages
    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: null })
      .where(eq(storages.id, testArtifactId));

    await globalThis.services.db
      .delete(storageVersions)
      .where(eq(storageVersions.storageId, testArtifactId));

    await globalThis.services.db
      .delete(storages)
      .where(eq(storages.id, testArtifactId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/platform/artifacts/download?name=${testArtifactName}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 when artifact not found", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/artifacts/download?name=non-existent-artifact",
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.message).toContain("non-existent-artifact");
  });

  it("should generate presigned URL with custom filename", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/platform/artifacts/download?name=${testArtifactName}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.url).toBe("https://example.com/presigned-url");
    expect(data.expiresAt).toBeDefined();

    // Verify generatePresignedUrl was called with correct filename
    expect(s3Client.generatePresignedUrl).toHaveBeenCalledTimes(1);
    const mockFn = vi.mocked(s3Client.generatePresignedUrl);
    const callArgs = mockFn.mock.calls[0]!;
    expect(callArgs[3]).toBe(`${testArtifactName}-${testVersionId}.tar.gz`);
  });

  it("should generate presigned URL with version-specific filename when version is provided", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/platform/artifacts/download?name=${testArtifactName}&version=${testVersionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.url).toBe("https://example.com/presigned-url");

    // Verify generatePresignedUrl was called with correct filename
    expect(s3Client.generatePresignedUrl).toHaveBeenCalledTimes(1);
    const mockFn = vi.mocked(s3Client.generatePresignedUrl);
    const callArgs = mockFn.mock.calls[0]!;
    expect(callArgs[3]).toBe(`${testArtifactName}-${testVersionId}.tar.gz`);
  });

  it("should return 404 when artifact has no versions", async () => {
    // Create an artifact without any version
    const emptyArtifactName = "empty-artifact";
    const [emptyArtifact] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: testUserId,
        name: emptyArtifactName,
        type: "artifact",
        s3Prefix: `${testUserId}/artifact/${emptyArtifactName}`,
        headVersionId: null,
      })
      .returning();

    const request = createTestRequest(
      `http://localhost:3000/api/platform/artifacts/download?name=${emptyArtifactName}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("has no versions");

    // Cleanup
    await globalThis.services.db
      .delete(storages)
      .where(eq(storages.id, emptyArtifact!.id));
  });

  it("should return 404 when version has no files", async () => {
    // Create an artifact with empty version (fileCount = 0)
    const emptyVersionArtifactName = "empty-version-artifact";
    const emptyVersionId =
      "empty123456789012345678901234567890123456789012345678901234";

    const [emptyVersionArtifact] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: testUserId,
        name: emptyVersionArtifactName,
        type: "artifact",
        s3Prefix: `${testUserId}/artifact/${emptyVersionArtifactName}`,
      })
      .returning();

    const [emptyVersion] = await globalThis.services.db
      .insert(storageVersions)
      .values({
        id: emptyVersionId,
        storageId: emptyVersionArtifact!.id,
        s3Key: `${testUserId}/artifact/${emptyVersionArtifactName}/${emptyVersionId}`,
        fileCount: 0,
        size: 0,
        createdBy: testUserId,
      })
      .returning();

    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: emptyVersion!.id })
      .where(eq(storages.id, emptyVersionArtifact!.id));

    const request = createTestRequest(
      `http://localhost:3000/api/platform/artifacts/download?name=${emptyVersionArtifactName}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("has no files");

    // Cleanup - first clear headVersionId, then delete version, then storage
    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: null })
      .where(eq(storages.id, emptyVersionArtifact!.id));
    await globalThis.services.db
      .delete(storageVersions)
      .where(eq(storageVersions.id, emptyVersionId));
    await globalThis.services.db
      .delete(storages)
      .where(eq(storages.id, emptyVersionArtifact!.id));
  });
});
