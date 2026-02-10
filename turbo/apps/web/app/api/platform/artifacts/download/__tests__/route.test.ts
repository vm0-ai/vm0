import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestArtifact,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/platform/artifacts/download", () => {
  let user: UserContext;
  let testArtifactName: string;
  let testVersionId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create test artifact with unique name
    testArtifactName = `test-artifact-${Date.now()}`;
    const artifact = await createTestArtifact(testArtifactName);
    testVersionId = artifact.versionId;
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

  it("should generate presigned URL for artifact download", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/platform/artifacts/download?name=${testArtifactName}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.url).toBe("https://mock-presigned-url");
    expect(data.expiresAt).toBeDefined();

    // Verify generatePresignedUrl was called with correct filename
    expect(context.mocks.s3.generatePresignedUrl).toHaveBeenCalledTimes(1);
    const callArgs = context.mocks.s3.generatePresignedUrl.mock.calls[0];
    expect(callArgs?.[3]).toBe(`${testArtifactName}-${testVersionId}.tar.gz`);
  });

  it("should generate presigned URL with version-specific filename when version is provided", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/platform/artifacts/download?name=${testArtifactName}&version=${testVersionId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.url).toBe("https://mock-presigned-url");

    // Verify generatePresignedUrl was called with correct filename
    expect(context.mocks.s3.generatePresignedUrl).toHaveBeenCalledTimes(1);
    const callArgs = context.mocks.s3.generatePresignedUrl.mock.calls[0];
    expect(callArgs?.[3]).toBe(`${testArtifactName}-${testVersionId}.tar.gz`);
  });

  it("should return 404 when artifact has no versions", async () => {
    // Create an artifact without committing (skipCommit leaves it in prepare-only state with no head version)
    const emptyArtifactName = `empty-artifact-${Date.now()}`;
    await createTestArtifact(emptyArtifactName, { skipCommit: true });

    const request = createTestRequest(
      `http://localhost:3000/api/platform/artifacts/download?name=${emptyArtifactName}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("has no versions");
  });

  it("should return 404 when version has no files", async () => {
    // Create an empty artifact (fileCount = 0)
    const emptyVersionArtifactName = `empty-version-artifact-${Date.now()}`;
    await createTestArtifact(emptyVersionArtifactName, { empty: true });

    const request = createTestRequest(
      `http://localhost:3000/api/platform/artifacts/download?name=${emptyVersionArtifactName}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("has no files");
  });

  it("should not return another user's artifact", async () => {
    // Create another user
    await context.setupUser({ prefix: "other" });

    // Create artifact for other user
    const otherArtifactName = `other-artifact-${Date.now()}`;
    await createTestArtifact(otherArtifactName);

    // Switch back to original user
    mockClerk({ userId: user.userId });

    // Try to access other user's artifact
    const request = createTestRequest(
      `http://localhost:3000/api/platform/artifacts/download?name=${otherArtifactName}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });
});
