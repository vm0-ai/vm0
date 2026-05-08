import { describe, it, expect, beforeEach } from "vitest";
import { GET, DELETE } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestVolume,
  findTestStorageByName,
  insertOrgCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { getInstructionsStorageName } from "@vm0/core/storage-names";

const context = testContext();

describe("DELETE /api/agent/composes/[id]", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should delete instructions volume and S3 objects when agent is deleted", async () => {
    const agentName = uniqueId("cleanup-agent");

    // Create agent and instructions volume
    const { composeId } = await createTestCompose(agentName);
    const storageName = getInstructionsStorageName(agentName);
    await createTestVolume(storageName);

    // Verify volume exists and get its s3Prefix
    const storageBefore = await findTestStorageByName(user.orgId, storageName);
    expect(storageBefore).toBeDefined();
    const { s3Prefix } = storageBefore!;

    // Configure listS3Objects to return mock objects for the storage prefix
    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: `${s3Prefix}/v1/archive.tar.gz`, size: 1024 },
      { key: `${s3Prefix}/v1/manifest.json`, size: 256 },
    ]);

    // Delete agent
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    expect(response.status).toBe(204);

    // Instructions volume should be deleted from DB
    const storageAfter = await findTestStorageByName(user.orgId, storageName);
    expect(storageAfter).toBeUndefined();

    // S3 objects should be listed and deleted
    expect(context.mocks.s3.listS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      s3Prefix,
    );
    expect(context.mocks.s3.deleteS3Objects).toHaveBeenCalledWith(
      "test-bucket",
      [`${s3Prefix}/v1/archive.tar.gz`, `${s3Prefix}/v1/manifest.json`],
    );
  });

  it("should not fail when agent has no instructions volume", async () => {
    const agentName = uniqueId("no-volume-agent");

    // Create agent without instructions volume
    const { composeId } = await createTestCompose(agentName);

    // Delete agent — should succeed without error
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    expect(response.status).toBe(204);
  });

  it("should not delete skill volumes when agent is deleted", async () => {
    const agentName = uniqueId("skill-agent");

    // Create agent, instructions volume, and skill volume
    const { composeId } = await createTestCompose(agentName);
    const instructionsName = getInstructionsStorageName(agentName);
    await createTestVolume(instructionsName);
    const skillName = `agent-skills@test-org/test-repo/tree/main/test-skill`;
    await createTestVolume(skillName);

    // Delete agent
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/${composeId}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    expect(response.status).toBe(204);

    // Instructions volume should be deleted
    const instructionsAfter = await findTestStorageByName(
      user.orgId,
      instructionsName,
    );
    expect(instructionsAfter).toBeUndefined();

    // Skill volume should still exist
    const skillAfter = await findTestStorageByName(user.orgId, skillName);
    expect(skillAfter).toBeDefined();
  });
});

describe("GET /api/agent/composes/[id]", () => {
  let testComposeId: string;
  let ownerOrgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    ownerOrgId = user.orgId;

    const { composeId } = await createTestCompose(uniqueId("agent"));
    testComposeId = composeId;
  });

  it("should return 400 for malformed compose id", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/91fc0bd84bba673393d9adfc1a0f4dec",
      { method: "GET" },
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
    expect(data.error.message).toContain("valid UUID");
  });

  describe("Cross-User Access Control", () => {
    // Note: API returns 404 (not 403) for unauthorized access to prevent
    // information leakage about existence of private agents
    it("should deny access to another user's private compose (returns 404)", async () => {
      // Switch to another user (different org)
      await context.setupUser({ prefix: "other-user" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await GET(request);
      const data = await response.json();

      // API returns 404 instead of 403 for security (don't leak existence of private agents)
      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should allow access when user is a member of the same org", async () => {
      // Switch to another user whose active org matches the compose's org.
      // Compose access is org-scoped: same org = access granted.
      mockClerk({
        userId: "other-user-123",
        orgId: ownerOrgId,
        clerkOrgs: [
          {
            id: ownerOrgId,
            slug: "shared-org",
            name: "Shared Org",
          },
        ],
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });

    it("should deny access when active org differs from compose org", async () => {
      // User is a member of the owner's org, but their active org is different.
      // Compose access is scoped to the caller's active org — cross-org access
      // is not allowed even if the user is a member of the compose's org.
      const differentOrgId = "org_different_active";

      // Populate org_cache so resolveOrg recognizes this org
      await insertOrgCacheEntry({
        orgId: differentOrgId,
        slug: "different-org",
      });

      mockClerk({
        userId: "other-user-456",
        orgId: differentOrgId,
        clerkOrgs: [
          {
            id: differentOrgId,
            slug: "different-org",
            name: "Different Org",
          },
          {
            id: ownerOrgId,
            slug: "shared-org",
            name: "Shared Org",
          },
        ],
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await GET(request);
      const data = await response.json();

      // Active org differs from compose's org — denied
      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should always allow owner to access their compose", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });
  });
});
