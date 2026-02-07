import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestArtifact,
  createTestVolume,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

function listStorages(type: string) {
  return GET(
    createTestRequest(`http://localhost:3000/api/storages/list?type=${type}`),
  );
}

describe("GET /api/storages/list", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await listStorages("artifact");
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 when user has no scope", async () => {
    // Create a user without a scope by mocking a different userId
    // that has no scope in the database
    mockClerk({ userId: "user-without-scope" });

    const response = await listStorages("artifact");
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 200 with empty array when no storages exist", async () => {
    const response = await listStorages("artifact");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([]);
  });

  it("should return 200 with artifacts when artifacts exist", async () => {
    await createTestArtifact("test-artifact-a");

    const response = await listStorages("artifact");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("error");
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("test-artifact-a");
    expect(body[0]).toHaveProperty("size");
    expect(body[0]).toHaveProperty("fileCount");
    expect(body[0]).toHaveProperty("updatedAt");
  });

  it("should return 200 with volumes when volumes exist", async () => {
    await createTestVolume("test-volume-a");

    const response = await listStorages("volume");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("error");
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("test-volume-a");
  });

  it("should filter by type and not return other storage types", async () => {
    await createTestArtifact("my-artifact");
    await createTestVolume("my-volume");

    const artifactResponse = await listStorages("artifact");
    const artifacts = await artifactResponse.json();

    expect(artifactResponse.status).toBe(200);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe("my-artifact");

    const volumeResponse = await listStorages("volume");
    const volumes = await volumeResponse.json();

    expect(volumeResponse.status).toBe(200);
    expect(volumes).toHaveLength(1);
    expect(volumes[0].name).toBe("my-volume");
  });
});
